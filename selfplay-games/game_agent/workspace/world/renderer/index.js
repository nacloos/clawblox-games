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
  if (typeof entity.model_url === 'string' && entity.model_url.length > 0) {
    return entity.model_url
  }
  const attrs = entity.attributes
  if (attrs && typeof attrs.ModelUrl === 'string' && attrs.ModelUrl.length > 0) {
    return attrs.ModelUrl
  }
  return null
}

function buildSky(scene) {
  const skyMat = new THREE.ShaderMaterial({
    uniforms: {
      topColor: { value: new THREE.Color(0x1a0a2e) },      // deep purple-black
      midColor: { value: new THREE.Color(0xff4500) },       // orange glow
      bottomColor: { value: new THREE.Color(0xff6347) },    // lava reflection
      lavaIntensity: { value: 0.0 },
    },
    vertexShader: `
      varying vec3 vWP;
      void main(){
        vWP = (modelMatrix * vec4(position, 1.0)).xyz;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform vec3 topColor, midColor, bottomColor;
      uniform float lavaIntensity;
      varying vec3 vWP;
      void main(){
        float h = normalize(vWP).y;
        vec3 skyTop = mix(vec3(0.53, 0.81, 0.92), topColor, lavaIntensity);
        vec3 skyMid = mix(vec3(1.0, 0.93, 0.82), midColor, lavaIntensity);
        vec3 skyBot = mix(vec3(0.93, 0.87, 0.73), bottomColor, lavaIntensity);
        vec3 col;
        if (h > 0.3) {
          col = mix(skyMid, skyTop, smoothstep(0.3, 0.8, h));
        } else {
          col = mix(skyBot, skyMid, smoothstep(-0.2, 0.3, h));
        }
        gl_FragColor = vec4(col, 1.0);
      }
    `,
    side: THREE.BackSide,
    depthWrite: false,
  })
  scene.add(new THREE.Mesh(new THREE.SphereGeometry(1500, 32, 32), skyMat))
  return skyMat
}

function buildClouds(scene) {
  const cloudList = []
  const cloudMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    transparent: true,
    opacity: 0.8,
    roughness: 1,
  })

  for (let i = 0; i < 20; i++) {
    const cg = new THREE.Group()
    for (let j = 0; j < 3 + Math.floor(Math.random() * 4); j++) {
      const p = new THREE.Mesh(new THREE.SphereGeometry(6 + Math.random() * 10, 8, 8), cloudMat)
      p.position.set(j * 8 - 16, Math.random() * 5, Math.random() * 6 - 3)
      p.scale.y = 0.6
      cg.add(p)
    }
    cg.position.set(Math.random() * 500 - 250, 100 + Math.random() * 80, Math.random() * 300 - 150)
    scene.add(cg)
    cloudList.push({ mesh: cg, speed: 0.5 + Math.random() * 1.5, mat: cloudMat })
  }

  return cloudList
}

function updateClouds(clouds, dt) {
  for (const c of clouds) {
    c.mesh.position.x += c.speed * dt
    if (c.mesh.position.x > 250) c.mesh.position.x = -250
  }
}

function createLavaMaterial() {
  return new THREE.ShaderMaterial({
    uniforms: {
      time: { value: 0.0 },
      lavaColor1: { value: new THREE.Color(0xff4500) },
      lavaColor2: { value: new THREE.Color(0xff8c00) },
      lavaColor3: { value: new THREE.Color(0xff0000) },
      glowColor: { value: new THREE.Color(0xffcc00) },
    },
    vertexShader: `
      varying vec2 vUv;
      varying vec3 vPos;
      uniform float time;
      void main() {
        vUv = uv;
        vPos = position;
        // Animated wave displacement
        vec3 p = position;
        p.y += sin(position.x * 0.3 + time * 1.5) * 0.3;
        p.y += sin(position.z * 0.2 + time * 0.8) * 0.4;
        p.y += sin((position.x + position.z) * 0.15 + time * 2.0) * 0.2;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
      }
    `,
    fragmentShader: `
      uniform float time;
      uniform vec3 lavaColor1, lavaColor2, lavaColor3, glowColor;
      varying vec2 vUv;
      varying vec3 vPos;

      // Simple noise
      float hash(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
      }
      float noise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        float a = hash(i);
        float b = hash(i + vec2(1.0, 0.0));
        float c = hash(i + vec2(0.0, 1.0));
        float d = hash(i + vec2(1.0, 1.0));
        return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
      }
      float fbm(vec2 p) {
        float v = 0.0;
        v += noise(p * 1.0) * 0.5;
        v += noise(p * 2.0 + time * 0.3) * 0.25;
        v += noise(p * 4.0 - time * 0.5) * 0.125;
        return v;
      }

      void main() {
        vec2 uv = vPos.xz * 0.05;
        float n1 = fbm(uv + time * 0.1);
        float n2 = fbm(uv * 1.5 - time * 0.15);

        vec3 col = mix(lavaColor1, lavaColor2, n1);
        col = mix(col, lavaColor3, n2 * 0.5);

        // Hot spots / bright cracks
        float crack = smoothstep(0.55, 0.7, n1 + n2 * 0.3);
        col = mix(col, glowColor, crack * 0.8);

        // Pulsing glow
        float pulse = sin(time * 3.0) * 0.1 + 0.9;
        col *= pulse;

        // Emissive glow at edges
        float edge = smoothstep(0.0, 0.3, n1);
        float alpha = 0.85 + edge * 0.15;

        gl_FragColor = vec4(col, alpha);
      }
    `,
    transparent: true,
    side: THREE.DoubleSide,
  })
}

function createCoinVisual() {
  const group = new THREE.Group()

  // Main coin body - golden torus-like shape
  const coinGeo = new THREE.CylinderGeometry(0.8, 0.8, 0.2, 16)
  const coinMat = new THREE.MeshStandardMaterial({
    color: 0xffd700,
    metalness: 0.9,
    roughness: 0.1,
    emissive: 0xffa500,
    emissiveIntensity: 0.4,
  })
  const coinMesh = new THREE.Mesh(coinGeo, coinMat)
  coinMesh.rotation.z = Math.PI / 2  // stand upright
  coinMesh.castShadow = true
  group.add(coinMesh)

  // Glow ring
  const ringGeo = new THREE.TorusGeometry(0.9, 0.05, 8, 32)
  const ringMat = new THREE.MeshStandardMaterial({
    color: 0xffff00,
    emissive: 0xffcc00,
    emissiveIntensity: 1.0,
    transparent: true,
    opacity: 0.6,
  })
  const ring = new THREE.Mesh(ringGeo, ringMat)
  group.add(ring)

  return group
}

function createEntityVisual(entity) {
  const role = (entity.render && entity.render.role) || 
               (entity.attributes && entity.attributes.RenderRole) || 
               entity.name || ''
  const size = entity.size || [1, 1, 1]
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

  if (role === 'Lava') {
    const group = new THREE.Group()
    group.userData.isLava = true
    const lavaMat = createLavaMaterial()
    group.userData.lavaMaterial = lavaMat
    const lavaGeo = new THREE.PlaneGeometry(200, 200, 64, 64)
    const lavaMesh = new THREE.Mesh(lavaGeo, lavaMat)
    lavaMesh.rotation.x = -Math.PI / 2
    lavaMesh.position.y = 0.5 // slightly above the Part center
    group.add(lavaMesh)

    // Lava point light for that ambient glow
    const lavaLight = new THREE.PointLight(0xff4500, 2, 80)
    lavaLight.position.y = 2
    group.add(lavaLight)
    group.userData.lavaLight = lavaLight

    return group
  }

  if (role === 'Coin') {
    const group = createCoinVisual()
    group.userData.isCoin = true
    group.userData.spinOffset = Math.random() * Math.PI * 2
    return group
  }

  if (role === 'DangerCoin') {
    const group = new THREE.Group()
    group.userData.isCoin = true
    group.userData.isDangerCoin = true
    group.userData.spinOffset = Math.random() * Math.PI * 2

    // Bigger, redder coin
    const coinGeo = new THREE.CylinderGeometry(1.2, 1.2, 0.3, 16)
    const coinMat = new THREE.MeshStandardMaterial({
      color: 0xff3333,
      metalness: 0.9,
      roughness: 0.1,
      emissive: 0xff0000,
      emissiveIntensity: 0.8,
    })
    const coinMesh = new THREE.Mesh(coinGeo, coinMat)
    coinMesh.rotation.z = Math.PI / 2
    coinMesh.castShadow = true
    group.add(coinMesh)

    // Pulsing red glow
    const glowGeo = new THREE.SphereGeometry(1.5, 16, 16)
    const glowMat = new THREE.MeshStandardMaterial({
      color: 0xff0000,
      emissive: 0xff4444,
      emissiveIntensity: 1.5,
      transparent: true,
      opacity: 0.3,
    })
    const glow = new THREE.Mesh(glowGeo, glowMat)
    group.add(glow)
    group.userData.glowMesh = glow

    // Red point light
    const light = new THREE.PointLight(0xff0000, 3, 15)
    group.add(light)

    return group
  }

  if (role === 'Ground') {
    const group = new THREE.Group()
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(size[0], size[1], size[2]),
      new THREE.MeshStandardMaterial({ color: 0x55efC4, roughness: 0.5, metalness: 0.2 }),
    )
    mesh.receiveShadow = true
    mesh.castShadow = true
    group.add(mesh)
    return group
  }

  if (role === 'Mesa') {
    const group = new THREE.Group()
    const w = size[0], h = size[1], d = size[2]

    const layers = [
      { frac: 0.0,  hFrac: 0.40, color: 0x8b6940 },
      { frac: 0.40, hFrac: 0.40, color: 0xa57d50 },
      { frac: 0.80, hFrac: 0.20, color: 0x55cfb0 },
    ]

    for (const layer of layers) {
      const lh = h * layer.hFrac
      const ly = -h / 2 + h * layer.frac + lh / 2
      const mesh = new THREE.Mesh(
        new THREE.BoxGeometry(w, lh, d),
        new THREE.MeshStandardMaterial({ color: layer.color, roughness: 0.9, metalness: 0.0 }),
      )
      mesh.position.y = ly
      mesh.castShadow = true
      mesh.receiveShadow = true
      group.add(mesh)
    }

    return group
  }

  // Default fallback
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
  const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 3000)

  const renderer = new THREE.WebGLRenderer({ canvas: ctx.canvas, antialias: true })
  renderer.shadowMap.enabled = true
  renderer.shadowMap.type = THREE.PCFSoftShadowMap
  renderer.toneMapping = THREE.ACESFilmicToneMapping
  renderer.toneMappingExposure = 1.2
  renderer.outputColorSpace = THREE.SRGBColorSpace

  // Lights
  const ambientLight = new THREE.AmbientLight(0xffffff, 0.6)
  scene.add(ambientLight)
  const hemiLight = new THREE.HemisphereLight(0x87ceeb, 0x98fb98, 0.4)
  scene.add(hemiLight)

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

  // Sky
  const skyMat = buildSky(scene)
  const clouds = buildClouds(scene)

  const stateBuffer = ctx.runtime.state.createSnapshotBuffer({ maxSnapshots: 8, interpolationDelayMs: 100 })
  const entityObjects = new Map()
  const modelController = ctx.runtime.three.createModelEntityController(THREE, {
    onError(err, meta) {
      ctx.log('warn', 'Model entity load failed', { err: String(err), ...meta })
    },
  })

  let followTargetPos = new THREE.Vector3(0, 4, 0)
  let camPos = new THREE.Vector3(0, 15, -20)
  let camTarget = new THREE.Vector3(0, 2, 0)
  const clock = new THREE.Clock()
  let totalTime = 0
  let currentLavaY = -1

  function updateCamera() {
    const tp = followTargetPos
    const ideal = new THREE.Vector3(tp.x, tp.y + 12, tp.z - 20)
    camPos.lerp(ideal, 0.05)
    camera.position.copy(camPos)
    camTarget.lerp(tp.clone().add(new THREE.Vector3(0, 2, 0)), 0.08)
    camera.lookAt(camTarget)
    dirLight.position.set(tp.x + 30, 50, tp.z + 20)
    dirLight.target.position.copy(tp)
  }

  function updateLavaEffects() {
    // Lava intensity for sky/lighting (0 = no lava visible, 1 = lava everywhere)
    const intensity = Math.min(1, Math.max(0, currentLavaY / 14))

    // Sky darkens as lava rises
    skyMat.uniforms.lavaIntensity.value = intensity

    // Ambient light shifts to orange/red
    ambientLight.color.lerpColors(
      new THREE.Color(0xffffff),
      new THREE.Color(0xff8844),
      intensity * 0.5,
    )
    ambientLight.intensity = 0.6 - intensity * 0.2

    // Hemisphere light shifts
    hemiLight.color.lerpColors(
      new THREE.Color(0x87ceeb),
      new THREE.Color(0xff4500),
      intensity * 0.6,
    )
    hemiLight.groundColor.lerpColors(
      new THREE.Color(0x98fb98),
      new THREE.Color(0xff6600),
      intensity * 0.8,
    )

    // Cloud tint toward ashy/dark
    for (const c of clouds) {
      c.mat.color.lerpColors(
        new THREE.Color(0xffffff),
        new THREE.Color(0x555555),
        intensity * 0.7,
      )
      c.mat.opacity = 0.8 - intensity * 0.3
    }
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

      // Track lava Y from the lava entity
      if (obj.userData.isLava) {
        currentLavaY = entity.position[1]
        // Update lava shader time
        if (obj.userData.lavaMaterial) {
          obj.userData.lavaMaterial.uniforms.time.value = totalTime
        }
        // Update lava light intensity based on height
        if (obj.userData.lavaLight) {
          obj.userData.lavaLight.intensity = 2 + Math.sin(totalTime * 2) * 0.5
          obj.userData.lavaLight.position.y = 2
        }
      }

      // Spin coins
      if (obj.userData.isCoin) {
        const spinSpeed = obj.userData.isDangerCoin ? 4.0 : 2.0
        obj.rotation.y = totalTime * spinSpeed + (obj.userData.spinOffset || 0)
        
        if (obj.userData.isDangerCoin) {
          // Aggressive pulsing for danger coins
          const pulse = 1.0 + Math.sin(totalTime * 5) * 0.25
          obj.scale.setScalar(pulse)
          // Glow pulsing
          if (obj.userData.glowMesh) {
            obj.userData.glowMesh.material.opacity = 0.2 + Math.sin(totalTime * 4) * 0.15
          }
        } else {
          // Gentle scale pulse for normal coins
          const pulse = 1.0 + Math.sin(totalTime * 3 + (obj.userData.spinOffset || 0)) * 0.1
          obj.scale.setScalar(pulse)
        }
      }

      const prev = obj.userData.prevPos
      let speed = 0
      if (prev) {
        const dx = entity.position[0] - prev[0]
        const dz = entity.position[2] - prev[2]
        speed = Math.sqrt(dx * dx + dz * dz) / Math.max(dt, 0.001)
      }
      obj.userData.prevPos = [entity.position[0], entity.position[1], entity.position[2]]

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
      
      updateClouds(clouds, dt)
      updateScene(obs, dt)
      updateLavaEffects()
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
