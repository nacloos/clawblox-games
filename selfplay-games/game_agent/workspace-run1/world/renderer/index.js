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

function resolveEntityModelUrl(entity) {
  if (typeof entity.model_url === 'string' && entity.model_url.length > 0) return entity.model_url
  const attrs = entity.attributes
  if (attrs && typeof attrs.ModelUrl === 'string' && attrs.ModelUrl.length > 0) return attrs.ModelUrl
  return null
}

// Dark arena sky
function buildSky(scene) {
  const skyMat = new THREE.ShaderMaterial({
    uniforms: {
      time: { value: 0 },
    },
    vertexShader: `
      varying vec3 vWP;
      void main(){
        vWP = (modelMatrix * vec4(position, 1.0)).xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform float time;
      varying vec3 vWP;
      void main(){
        float h = normalize(vWP).y;
        vec3 top = vec3(0.04, 0.03, 0.1);
        vec3 mid = vec3(0.12, 0.06, 0.18);
        vec3 bot = vec3(0.2, 0.08, 0.12);
        vec3 col;
        if (h > 0.2) {
          col = mix(mid, top, smoothstep(0.2, 0.8, h));
        } else {
          col = mix(bot, mid, smoothstep(-0.3, 0.2, h));
        }
        // Subtle pulse
        col += 0.01 * sin(time * 0.5);
        gl_FragColor = vec4(col, 1.0);
      }
    `,
    side: THREE.BackSide,
    depthWrite: false,
  })
  scene.add(new THREE.Mesh(new THREE.SphereGeometry(1500, 32, 32), skyMat))
  return skyMat
}

// Arena floor with grid pattern
function createFloorMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      time: { value: 0 },
    },
    vertexShader: `
      varying vec2 vUv;
      varying vec3 vPos;
      void main() {
        vUv = uv;
        vPos = position;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform float time;
      varying vec3 vPos;
      void main() {
        // Grid lines
        float gridX = abs(fract(vPos.x * 0.1) - 0.5);
        float gridZ = abs(fract(vPos.z * 0.1) - 0.5);
        float grid = smoothstep(0.48, 0.5, gridX) + smoothstep(0.48, 0.5, gridZ);
        
        vec3 base = vec3(0.12, 0.12, 0.18);
        vec3 line = vec3(0.25, 0.18, 0.4);
        
        // Distance-based fade from center
        float dist = length(vPos.xz) / 50.0;
        float fade = 1.0 - smoothstep(0.0, 1.0, dist);
        
        vec3 col = mix(base, line, grid * 0.6);
        // Center glow
        col += vec3(0.1, 0.04, 0.15) * fade;
        
        gl_FragColor = vec4(col, 1.0);
      }
    `,
  })
}

function createEnemyVisual(entity) {
  const group = new THREE.Group()
  const type = entity.attributes?.EnemyType || 'Runner'
  const size = entity.size || [2, 4, 2]

  let color, emissive, geo
  if (type === 'Runner') {
    color = 0xff5555
    emissive = 0xaa2222
    geo = new THREE.CapsuleGeometry(size[0] / 2.2, size[1] / 2, 8, 16)
  } else if (type === 'Tank') {
    color = 0xbb4444
    emissive = 0x882222
    geo = new THREE.BoxGeometry(size[0], size[1], size[2])
  } else if (type === 'Dasher') {
    color = 0xffaa44
    emissive = 0xcc6600
    geo = new THREE.ConeGeometry(size[0] / 2, size[1], 6)
  } else {
    color = 0xff0000
    emissive = 0x330000
    geo = new THREE.BoxGeometry(size[0], size[1], size[2])
  }

  const mat = new THREE.MeshStandardMaterial({
    color,
    emissive,
    emissiveIntensity: 0.8,
    roughness: 0.4,
    metalness: 0.3,
  })
  const mesh = new THREE.Mesh(geo, mat)
  mesh.castShadow = true
  group.add(mesh)

  // Eyes (two glowing dots)
  const eyeGeo = new THREE.SphereGeometry(0.15, 8, 8)
  const eyeMat = new THREE.MeshStandardMaterial({
    color: 0xffff00,
    emissive: 0xffff00,
    emissiveIntensity: 2,
  })
  const eyeL = new THREE.Mesh(eyeGeo, eyeMat)
  const eyeR = new THREE.Mesh(eyeGeo, eyeMat)
  eyeL.position.set(-0.35, size[1] * 0.25, size[2] / 2.2)
  eyeR.position.set(0.35, size[1] * 0.25, size[2] / 2.2)
  group.add(eyeL, eyeR)

  // Health bar above head
  const barBg = new THREE.Mesh(
    new THREE.PlaneGeometry(2, 0.3),
    new THREE.MeshBasicMaterial({ color: 0x333333, side: THREE.DoubleSide }),
  )
  barBg.position.y = size[1] / 2 + 1
  group.add(barBg)

  const barFill = new THREE.Mesh(
    new THREE.PlaneGeometry(2, 0.3),
    new THREE.MeshBasicMaterial({ color: 0xff0000, side: THREE.DoubleSide }),
  )
  barFill.position.y = size[1] / 2 + 1
  barFill.position.z = 0.01
  group.add(barFill)

  group.userData.healthBar = barFill
  group.userData.enemyMaterial = mat

  return group
}

function createEntityVisual(entity) {
  const role = entity.attributes?.RenderRole || entity.name || ''
  const size = entity.size || [1, 1, 1]
  const modelUrl = resolveEntityModelUrl(entity)

  if (modelUrl) {
    const root = new THREE.Group()
    root.userData.isModelEntity = true
    root.userData.modelUrl = modelUrl
    const fallback = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.35, 0.5, 8, 16),
      new THREE.MeshStandardMaterial({ color: 0x44aaff, roughness: 0.5, metalness: 0.05 }),
    )
    fallback.castShadow = true
    const scale = (size[1] || 5) / 1.3
    fallback.scale.setScalar(scale)
    root.add(fallback)
    return root
  }

  if (role === 'Enemy') {
    return createEnemyVisual(entity)
  }

  if (role === 'ArenaFloor') {
    const group = new THREE.Group()
    group.userData.isFloor = true
    const floorMat = createFloorMaterial()
    group.userData.floorMaterial = floorMat
    const geo = new THREE.PlaneGeometry(size[0], size[2], 1, 1)
    const mesh = new THREE.Mesh(geo, floorMat)
    mesh.rotation.x = -Math.PI / 2
    mesh.position.y = 0.5
    mesh.receiveShadow = true
    group.add(mesh)
    return group
  }

  if (role === 'Wall') {
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(size[0], size[1], size[2]),
      new THREE.MeshStandardMaterial({
        color: 0x882222,
        emissive: 0x441111,
        emissiveIntensity: 0.4,
        roughness: 0.7,
        metalness: 0.3,
      }),
    )
    mesh.castShadow = true
    mesh.receiveShadow = true
    return mesh
  }

  if (role === 'Pillar') {
    const group = new THREE.Group()
    const mesh = new THREE.Mesh(
      new THREE.CylinderGeometry(size[0] / 2, size[0] / 2 + 0.3, size[1], 8),
      new THREE.MeshStandardMaterial({
        color: 0x887766,
        roughness: 0.9,
        metalness: 0.1,
      }),
    )
    mesh.castShadow = true
    mesh.receiveShadow = true
    group.add(mesh)

    // Top glow ring
    const ring = new THREE.Mesh(
      new THREE.TorusGeometry(size[0] / 2 + 0.2, 0.1, 8, 16),
      new THREE.MeshStandardMaterial({
        color: 0x4488ff,
        emissive: 0x2244aa,
        emissiveIntensity: 1,
      }),
    )
    ring.rotation.x = Math.PI / 2
    ring.position.y = size[1] / 2
    group.add(ring)

    return group
  }

  if (role === 'Powerup') {
    const group = new THREE.Group()
    group.userData.isPowerup = true
    group.userData.spinOffset = Math.random() * Math.PI * 2

    const type = entity.attributes?.PowerupType || 'HealPack'
    let color = 0x00ff00
    if (type === 'SpeedBoost') color = 0x32c8ff
    else if (type === 'DamageBoost') color = 0xff3232
    else if (type === 'RapidFire') color = 0xffff32
    else if (type === 'HealPack') color = 0x32ff32

    // Floating orb
    const orbMat = new THREE.MeshStandardMaterial({
      color,
      emissive: color,
      emissiveIntensity: 1.5,
      transparent: true,
      opacity: 0.85,
      roughness: 0.1,
      metalness: 0.8,
    })
    const orb = new THREE.Mesh(new THREE.IcosahedronGeometry(0.6, 1), orbMat)
    group.add(orb)

    // Glow sphere
    const glow = new THREE.Mesh(
      new THREE.SphereGeometry(1.2, 16, 16),
      new THREE.MeshStandardMaterial({
        color,
        emissive: color,
        emissiveIntensity: 0.8,
        transparent: true,
        opacity: 0.15,
      }),
    )
    group.add(glow)

    // Point light
    const light = new THREE.PointLight(color, 2, 10)
    group.add(light)

    return group
  }

  if (role === 'Shockwave') {
    const group = new THREE.Group()
    group.userData.isShockwave = true
    
    // Expanding ring
    const ringGeo = new THREE.TorusGeometry(10, 0.5, 8, 32)
    const ringMat = new THREE.MeshStandardMaterial({
      color: 0x6699ff,
      emissive: 0x3366ff,
      emissiveIntensity: 3,
      transparent: true,
      opacity: 0.7,
    })
    const ring = new THREE.Mesh(ringGeo, ringMat)
    ring.rotation.x = Math.PI / 2
    group.add(ring)

    // Central flash
    const flash = new THREE.Mesh(
      new THREE.SphereGeometry(3, 16, 16),
      new THREE.MeshStandardMaterial({
        color: 0xffffff,
        emissive: 0x6699ff,
        emissiveIntensity: 5,
        transparent: true,
        opacity: 0.5,
      }),
    )
    group.add(flash)

    // Bright point light
    const light = new THREE.PointLight(0x6699ff, 10, 40)
    group.add(light)

    group.userData.shockMat = ringMat
    group.userData.flashMat = flash.material
    group.userData.shockLight = light

    return group
  }

  if (role === 'BulletTrail') {
    const hitEnemy = entity.attributes?.HitEnemy
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(size[0], size[1], size[2]),
      new THREE.MeshStandardMaterial({
        color: hitEnemy ? 0xffff44 : 0x8888ff,
        emissive: hitEnemy ? 0xffaa00 : 0x4444ff,
        emissiveIntensity: 2,
        transparent: true,
        opacity: 0.8,
      }),
    )
    return mesh
  }

  // Default
  const color = entity.render?.color
    ? (Math.round(entity.render.color[0] * 255) << 16) |
      (Math.round(entity.render.color[1] * 255) << 8) |
      Math.round(entity.render.color[2] * 255)
    : 0x999999

  const mesh = new THREE.Mesh(
    new THREE.BoxGeometry(size[0], size[1], size[2]),
    new THREE.MeshStandardMaterial({ color, roughness: 0.5, metalness: 0.2 }),
  )
  mesh.castShadow = true
  mesh.receiveShadow = true
  return mesh
}

export function createRenderer(ctx) {
  const scene = new THREE.Scene()
  scene.fog = new THREE.FogExp2(0x0a0a15, 0.004)  // Less dense fog

  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 3000)

  const renderer = new THREE.WebGLRenderer({ canvas: ctx.canvas, antialias: true })
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.4
  renderer.outputColorSpace = THREE.SRGBColorSpace

  // Lighting — dramatic but visible arena
  const ambientLight = new THREE.AmbientLight(0x333344, 0.8)
  scene.add(ambientLight)

  const hemiLight = new THREE.HemisphereLight(0x3344aa, 0x221111, 0.6)
  scene.add(hemiLight)

  // Central overhead light
  const dirLight = new THREE.DirectionalLight(0x5566cc, 1.0)
  dirLight.position.set(20, 50, 10)
  dirLight.castShadow = true
  dirLight.shadow.mapSize.set(2048, 2048)
  dirLight.shadow.camera.left = -50
  dirLight.shadow.camera.right = 50
  dirLight.shadow.camera.top = 50
  dirLight.shadow.camera.bottom = -50
  scene.add(dirLight)
  scene.add(dirLight.target)

  // Central spotlight
  const spotLight = new THREE.SpotLight(0x6688ff, 4, 100, Math.PI / 3, 0.3, 0.8)
  spotLight.position.set(0, 50, 0)
  spotLight.castShadow = true
  spotLight.shadow.mapSize.set(2048, 2048)
  scene.add(spotLight)
  scene.add(spotLight.target)

  // Red rim lights at arena edges — brighter
  const rimColors = [0xff2200, 0xff4400, 0xff2200, 0xff4400]
  const rimPositions = [[0, 12, -40], [0, 12, 40], [40, 12, 0], [-40, 12, 0]]
  for (let i = 0; i < 4; i++) {
    const rl = new THREE.PointLight(rimColors[i], 3, 80)
    rl.position.set(...rimPositions[i])
    scene.add(rl)
  }

  const skyMat = buildSky(scene)

  const stateBuffer = ctx.runtime.state.createSnapshotBuffer({ maxSnapshots: 8, interpolationDelayMs: 100 })
  const entityObjects = new Map()
  const modelController = ctx.runtime.three.createModelEntityController(THREE, {
    onError(err, meta) {
      ctx.log('warn', 'Model load failed', { err: String(err), ...meta })
    },
  })

  let followTargetPos = new THREE.Vector3(0, 4, 0)
  let camPos = new THREE.Vector3(0, 25, -30)
  let camTarget = new THREE.Vector3(0, 0, 0)
  const clock = new THREE.Clock()
  let totalTime = 0

  function updateCamera() {
    const tp = followTargetPos
    const ideal = new THREE.Vector3(tp.x, tp.y + 18, tp.z - 22)
    camPos.lerp(ideal, 0.06)
    camera.position.copy(camPos)
    camTarget.lerp(tp.clone().add(new THREE.Vector3(0, 1, 0)), 0.08)
    camera.lookAt(camTarget)
    spotLight.target.position.copy(tp)
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

      // Update floor shader
      if (obj.userData.isFloor && obj.userData.floorMaterial) {
        obj.userData.floorMaterial.uniforms.time.value = totalTime
      }

      // Update enemy health bars and facing
      if (entity.attributes?.RenderRole === 'Enemy' && obj.userData.healthBar) {
        const hp = entity.attributes.Health || 0
        const maxHp = entity.attributes.MaxHealth || 100
        const ratio = Math.max(0, hp / maxHp)
        obj.userData.healthBar.scale.x = ratio
        obj.userData.healthBar.position.x = -(1 - ratio)

        // Flash red when damaged
        if (obj.userData.enemyMaterial && ratio < 0.5) {
          obj.userData.enemyMaterial.emissiveIntensity = 0.5 + Math.sin(totalTime * 8) * 0.3
        }

        // Make health bar face camera
        if (obj.userData.healthBar.parent) {
          obj.userData.healthBar.parent.children.forEach(child => {
            if (child.geometry?.type === 'PlaneGeometry') {
              child.lookAt(camera.position)
            }
          })
        }
      }

      // Animate shockwave
      if (obj.userData.isShockwave) {
        const age = totalTime - (obj.userData.shockSpawnTime || totalTime)
        if (!obj.userData.shockSpawnTime) obj.userData.shockSpawnTime = totalTime
        const expand = 1 + age * 3  // Expand quickly
        obj.scale.setScalar(expand)
        if (obj.userData.shockMat) obj.userData.shockMat.opacity = Math.max(0, 0.7 - age * 2)
        if (obj.userData.flashMat) obj.userData.flashMat.opacity = Math.max(0, 0.5 - age * 1.5)
        if (obj.userData.shockLight) obj.userData.shockLight.intensity = Math.max(0, 10 - age * 25)
      }

      // Animate powerups
      if (obj.userData.isPowerup) {
        obj.rotation.y = totalTime * 3 + (obj.userData.spinOffset || 0)
        const bob = Math.sin(totalTime * 4 + (obj.userData.spinOffset || 0)) * 0.3
        obj.position.y += bob * dt * 2
        const pulse = 1.0 + Math.sin(totalTime * 5) * 0.15
        obj.scale.setScalar(pulse)
      }

      // Track player position
      const prev = obj.userData.prevPos
      let speed = 0
      if (prev) {
        const dx = entity.position[0] - prev[0]
        const dz = entity.position[2] - prev[2]
        speed = Math.sqrt(dx * dx + dz * dz) / Math.max(dt, 0.001)
      }
      obj.userData.prevPos = [...entity.position]

      if (obj.userData.isModelEntity) {
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

    // Remove gone entities
    for (const [id, obj] of entityObjects.entries()) {
      if (!activeIds.has(id)) {
        scene.remove(obj)
        modelController.remove(id)
        entityObjects.delete(id)
      }
    }

    // Follow player
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
      const dt = Math.min(clock.getDelta(), 0.05)
      totalTime += dt

      skyMat.uniforms.time.value = totalTime
      updateScene(obs, dt)
      updateCamera()
      renderer.render(scene, camera)
    },

    unmount() {
      for (const obj of entityObjects.values()) scene.remove(obj)
      entityObjects.clear()
      modelController.clear()
      renderer.dispose()
    },
  }
}
