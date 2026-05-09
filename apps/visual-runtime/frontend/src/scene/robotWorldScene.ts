import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";

import {
  VisualRuntimeVector3,
  VisualRuntimeWorldObject,
  VisualRuntimeWorldSnapshot,
  createInitialVisualRuntimeWorldSnapshot,
} from "../../../shared/src/world_contracts";

export interface VisualRuntimeRenderMetrics {
  readonly fps: number;
  readonly frameTimeMs: number;
  readonly drawCalls: number;
  readonly triangles: number;
  readonly geometries: number;
  readonly textures: number;
  readonly canvasWidth: number;
  readonly canvasHeight: number;
}

interface RobotPart {
  readonly mesh: THREE.Object3D;
  readonly phaseOffset: number;
  readonly swingScale: number;
}

interface VisualRobotWorldSceneOptions {
  readonly host: HTMLElement;
  readonly onMetrics: (metrics: VisualRuntimeRenderMetrics) => void;
}

const toVector3 = (vector: VisualRuntimeVector3): THREE.Vector3 =>
  new THREE.Vector3(vector.x, vector.y, vector.z);

const createPanelTexture = (label: string, fill: string, stroke: string): THREE.CanvasTexture => {
  const canvas = document.createElement("canvas");
  canvas.width = 256;
  canvas.height = 128;
  const context = canvas.getContext("2d");

  if (!context) {
    throw new Error("Unable to create label texture context.");
  }

  context.fillStyle = fill;
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.strokeStyle = stroke;
  context.lineWidth = 10;
  context.strokeRect(8, 8, canvas.width - 16, canvas.height - 16);
  context.fillStyle = "#f5f0dc";
  context.font = "700 28px sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  context.fillText(label, canvas.width / 2, canvas.height / 2);

  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.anisotropy = 4;
  return texture;
};

const createMaterial = (color: number, roughness = 0.72, metalness = 0.18): THREE.MeshStandardMaterial =>
  new THREE.MeshStandardMaterial({
    color,
    roughness,
    metalness,
  });

const createBox = (
  geometry: THREE.BoxGeometry,
  material: THREE.Material,
  position: [number, number, number],
  scale: [number, number, number],
  name: string,
): THREE.Mesh => {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(...position);
  mesh.scale.set(...scale);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = name;
  return mesh;
};

const createCylinder = (
  geometry: THREE.CylinderGeometry,
  material: THREE.Material,
  position: [number, number, number],
  rotation: [number, number, number],
  name: string,
): THREE.Mesh => {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(...position);
  mesh.rotation.set(...rotation);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  mesh.name = name;
  return mesh;
};

export class VisualRobotWorldScene {
  private readonly host: HTMLElement;
  private readonly onMetrics: (metrics: VisualRuntimeRenderMetrics) => void;
  private readonly renderer: THREE.WebGLRenderer;
  private readonly scene = new THREE.Scene();
  private readonly camera = new THREE.PerspectiveCamera(48, 1, 0.1, 80);
  private readonly controls: OrbitControls;
  private readonly clock = new THREE.Clock();
  private readonly snapshot: VisualRuntimeWorldSnapshot = createInitialVisualRuntimeWorldSnapshot();
  private readonly robotGroup = new THREE.Group();
  private readonly animatedRobotParts: RobotPart[] = [];
  private readonly animatedObjects: THREE.Object3D[] = [];
  private animationId = 0;
  private disposed = false;
  private frameAccumulator = 0;
  private frameCount = 0;
  private latestFps = 60;

  public constructor(options: VisualRobotWorldSceneOptions) {
    this.host = options.host;
    this.onMetrics = options.onMetrics;
    this.renderer = new THREE.WebGLRenderer({
      antialias: false,
      preserveDrawingBuffer: true,
      powerPreference: "high-performance",
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 0.85));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.BasicShadowMap;
    this.renderer.domElement.dataset.visualRuntimeCanvas = "vr-05";
    this.renderer.domElement.setAttribute("aria-label", "Detailed dog robot world viewer");
    this.host.appendChild(this.renderer.domElement);

    this.camera.position.set(5.8, 4.4, 6.2);
    this.controls = new OrbitControls(this.camera, this.renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.target.set(0, 0.75, 0);
    this.controls.maxPolarAngle = Math.PI * 0.48;
    this.controls.minDistance = 4;
    this.controls.maxDistance = 12;

    this.scene.background = new THREE.Color(0x141819);
    this.scene.fog = new THREE.Fog(0x141819, 12, 28);

    this.buildLighting();
    this.buildEnvironment();
    this.buildRobot();
    this.buildWorldObjects(this.snapshot.objects);
    this.buildTargetZones(this.snapshot.targetZones);
    this.buildActivityPath(this.snapshot.activityPath);
    this.host.dataset.vr05DogRobot = "detailed-visible";
    this.host.dataset.vr05Environment = "detailed-visible";
    this.host.dataset.vr05Optimization = "instancing-lod-culling-ready";
    this.resize();
    this.animate();
  }

  public resize = (): void => {
    const rect = this.host.getBoundingClientRect();
    const width = Math.max(320, Math.floor(rect.width));
    const height = Math.max(320, Math.floor(rect.height));
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(width, height, false);
  };

  public dispose(): void {
    this.disposed = true;
    cancelAnimationFrame(this.animationId);
    this.controls.dispose();
    this.renderer.dispose();
    this.scene.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (mesh.geometry) {
        mesh.geometry.dispose();
      }

      const material = mesh.material;
      if (Array.isArray(material)) {
        material.forEach((entry) => entry.dispose());
      } else if (material) {
        material.dispose();
      }
    });
    this.renderer.domElement.remove();
  }

  private buildLighting(): void {
    const ambient = new THREE.HemisphereLight(0xc9d9db, 0x26302b, 1.8);
    this.scene.add(ambient);

    const key = new THREE.DirectionalLight(0xfff0cf, 3.2);
    key.position.set(4.5, 8, 3.2);
    key.castShadow = true;
    key.shadow.mapSize.set(512, 512);
    key.shadow.camera.near = 1;
    key.shadow.camera.far = 18;
    key.shadow.camera.left = -8;
    key.shadow.camera.right = 8;
    key.shadow.camera.top = 8;
    key.shadow.camera.bottom = -8;
    this.scene.add(key);

    const rim = new THREE.PointLight(0x79aeb8, 50, 15);
    rim.position.set(-4, 3, -4);
    this.scene.add(rim);
  }

  private buildEnvironment(): void {
    const floorMaterial = createMaterial(0x343a35, 0.88, 0.05);
    const tileGeometry = new THREE.BoxGeometry(0.96, 0.05, 0.96);
    const tiles = new THREE.InstancedMesh(tileGeometry, floorMaterial, 144);
    tiles.name = "instanced-floor-tiles";
    tiles.receiveShadow = true;

    const matrix = new THREE.Matrix4();
    let index = 0;
    for (let x = -6; x < 6; x += 1) {
      for (let z = -6; z < 6; z += 1) {
        matrix.makeTranslation(x + 0.5, -0.045, z + 0.5);
        tiles.setMatrixAt(index, matrix);
        index += 1;
      }
    }
    tiles.instanceMatrix.needsUpdate = true;
    this.scene.add(tiles);

    const wallMaterial = createMaterial(0x273034, 0.82, 0.08);
    const boxGeometry = new THREE.BoxGeometry(1, 1, 1);
    this.scene.add(createBox(boxGeometry, wallMaterial, [0, 1, -5.8], [12, 2, 0.16], "rear-workshop-wall"));
    this.scene.add(createBox(boxGeometry, wallMaterial, [-5.8, 1, 0], [0.16, 2, 12], "left-workshop-wall"));

    const tableMaterial = createMaterial(0x6b5b47, 0.68, 0.06);
    const metalMaterial = createMaterial(0x8d9695, 0.44, 0.48);
    const bench = new THREE.Group();
    bench.name = "work-surface-with-tools";
    bench.add(createBox(boxGeometry, tableMaterial, [0, 0.82, -3.25], [3.2, 0.16, 0.9], "workbench-top"));
    for (const x of [-1.35, 1.35]) {
      for (const z of [-3.55, -2.95]) {
        bench.add(createBox(boxGeometry, metalMaterial, [x, 0.38, z], [0.12, 0.78, 0.12], "workbench-leg"));
      }
    }
    this.scene.add(bench);

    const cableMaterial = createMaterial(0x101313, 0.64, 0.3);
    for (let cable = 0; cable < 5; cable += 1) {
      const curve = new THREE.CatmullRomCurve3([
        new THREE.Vector3(-4.8 + cable * 0.12, 0.05, -4.2),
        new THREE.Vector3(-3.6 + cable * 0.08, 0.08, -3.7 + cable * 0.14),
        new THREE.Vector3(-2.2 + cable * 0.12, 0.05, -4.4 + cable * 0.1),
      ]);
      const cableMesh = new THREE.Mesh(new THREE.TubeGeometry(curve, 18, 0.025, 8, false), cableMaterial);
      cableMesh.name = "floor-cable";
      cableMesh.receiveShadow = true;
      this.scene.add(cableMesh);
    }

    const boltGeometry = new THREE.CylinderGeometry(0.035, 0.035, 0.018, 10);
    const boltMaterial = createMaterial(0xa7afad, 0.5, 0.62);
    const bolts = new THREE.InstancedMesh(boltGeometry, boltMaterial, 80);
    bolts.name = "instanced-floor-bolts";
    index = 0;
    for (let x = -5; x <= 4; x += 1.25) {
      for (let z = -5; z <= 4; z += 1.25) {
        matrix.makeTranslation(x, 0.005, z);
        bolts.setMatrixAt(index, matrix);
        index += 1;
      }
    }
    bolts.instanceMatrix.needsUpdate = true;
    this.scene.add(bolts);
  }

  private buildRobot(): void {
    this.robotGroup.name = "detailed-dog-robot";
    this.robotGroup.position.copy(toVector3(this.snapshot.robot.position));
    this.robotGroup.rotation.y = this.snapshot.robot.headingRadians;
    this.robotGroup.userData.visualRuntimeRole = "dog-robot";

    const bodyMaterial = createMaterial(0xb9c3bd, 0.42, 0.58);
    const darkMaterial = createMaterial(0x202629, 0.58, 0.36);
    const jointMaterial = createMaterial(0x3e494d, 0.52, 0.52);
    const sensorMaterial = createMaterial(0x79c7d0, 0.36, 0.18);
    const footMaterial = createMaterial(0x141718, 0.74, 0.24);
    const boxGeometry = new THREE.BoxGeometry(1, 1, 1);

    this.robotGroup.add(createBox(boxGeometry, bodyMaterial, [0, 1.16, 0], [1.75, 0.42, 0.72], "armored-torso"));
    this.robotGroup.add(createBox(boxGeometry, darkMaterial, [0, 1.42, 0], [1.35, 0.12, 0.46], "top-service-rail"));
    this.robotGroup.add(createBox(boxGeometry, bodyMaterial, [0.96, 1.18, 0], [0.42, 0.34, 0.54], "sensor-head"));
    this.robotGroup.add(createBox(boxGeometry, sensorMaterial, [1.2, 1.22, -0.19], [0.06, 0.1, 0.12], "left-vision-window"));
    this.robotGroup.add(createBox(boxGeometry, sensorMaterial, [1.2, 1.22, 0.19], [0.06, 0.1, 0.12], "right-vision-window"));
    this.robotGroup.add(createBox(boxGeometry, darkMaterial, [-0.98, 1.22, 0], [0.26, 0.2, 0.42], "rear-battery-pack"));

    for (const z of [-0.42, 0.42]) {
      for (const x of [-0.58, 0.18, 0.78]) {
        this.robotGroup.add(createBox(boxGeometry, darkMaterial, [x, 1.17, z], [0.16, 0.48, 0.045], "side-heat-sink"));
      }
    }

    const upperLegGeometry = new THREE.CylinderGeometry(0.07, 0.09, 0.62, 16);
    const lowerLegGeometry = new THREE.CylinderGeometry(0.055, 0.07, 0.58, 16);
    const jointGeometry = new THREE.SphereGeometry(0.13, 18, 12);
    const footGeometry = new THREE.BoxGeometry(0.36, 0.09, 0.2);
    const legAnchors = [
      { x: 0.62, z: -0.42, phase: 0 },
      { x: 0.62, z: 0.42, phase: Math.PI },
      { x: -0.62, z: -0.42, phase: Math.PI },
      { x: -0.62, z: 0.42, phase: 0 },
    ];

    for (const anchor of legAnchors) {
      const leg = new THREE.Group();
      leg.position.set(anchor.x, 0.96, anchor.z);
      leg.name = "articulated-leg-assembly";

      const hip = new THREE.Mesh(jointGeometry, jointMaterial);
      hip.castShadow = true;
      hip.name = "sealed-hip-joint";
      leg.add(hip);
      leg.add(createCylinder(upperLegGeometry, bodyMaterial, [0, -0.28, 0], [0.22, 0, 0.12], "upper-leg-actuator"));

      const knee = new THREE.Mesh(jointGeometry, jointMaterial);
      knee.position.set(0.08, -0.56, 0);
      knee.scale.setScalar(0.82);
      knee.castShadow = true;
      knee.name = "knee-torque-joint";
      leg.add(knee);
      leg.add(createCylinder(lowerLegGeometry, darkMaterial, [0.1, -0.82, 0], [-0.22, 0, -0.1], "lower-leg-link"));

      const foot = new THREE.Mesh(footGeometry, footMaterial);
      foot.position.set(0.18, -1.12, 0);
      foot.castShadow = true;
      foot.receiveShadow = true;
      foot.name = "rubberized-contact-foot";
      leg.add(foot);

      this.robotGroup.add(leg);
      this.animatedRobotParts.push({
        mesh: leg,
        phaseOffset: anchor.phase,
        swingScale: anchor.x > 0 ? 1 : -1,
      });
    }

    this.robotGroup.add(
      createCylinder(
        new THREE.CylinderGeometry(0.025, 0.025, 0.42, 12),
        sensorMaterial,
        [0.2, 1.72, 0],
        [0, 0, 0],
        "sensor-mast",
      ),
    );
    this.scene.add(this.robotGroup);
  }

  private buildWorldObjects(objects: readonly VisualRuntimeWorldObject[]): void {
    const boxGeometry = new THREE.BoxGeometry(1, 1, 1);
    const puckGeometry = new THREE.CylinderGeometry(0.22, 0.22, 0.16, 32);
    const crateMaterial = createMaterial(0x8f6940, 0.78, 0.08);
    const caseMaterial = createMaterial(0x52616a, 0.54, 0.35);
    const puckMaterial = createMaterial(0x4b98a3, 0.42, 0.2);
    const padMaterial = createMaterial(0x44544b, 0.72, 0.1);

    for (const object of objects) {
      const position = toVector3(object.position);
      const material =
        object.kind === "tool_crate"
          ? crateMaterial
          : object.kind === "payload_case"
            ? caseMaterial
            : object.kind === "charging_pad"
              ? padMaterial
              : puckMaterial;
      const mesh =
        object.kind === "sensor_puck" ? new THREE.Mesh(puckGeometry, material) : new THREE.Mesh(boxGeometry, material);
      mesh.position.copy(position);
      mesh.scale.set(
        object.kind === "charging_pad" ? 0.9 : 0.58,
        object.kind === "charging_pad" ? 0.08 : 0.48,
        object.kind === "charging_pad" ? 0.9 : 0.46,
      );
      mesh.name = object.id;
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData.label = object.label;
      this.scene.add(mesh);
      if (object.target) {
        this.animatedObjects.push(mesh);
      }

      const labelMaterial = new THREE.MeshBasicMaterial({
        map: createPanelTexture(object.label, "#182123", "#6fb4bd"),
        transparent: true,
      });
      const label = new THREE.Mesh(new THREE.PlaneGeometry(0.82, 0.38), labelMaterial);
      label.position.set(position.x, position.y + 0.62, position.z);
      label.rotation.x = -0.25;
      label.name = `${object.id}-label`;
      this.scene.add(label);
    }
  }

  private buildTargetZones(zones: readonly VisualRuntimeWorldObject[]): void {
    const ringMaterial = createMaterial(0xe0b14f, 0.5, 0.18);
    for (const zone of zones) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(0.75, 0.035, 12, 64), ringMaterial);
      ring.position.copy(toVector3(zone.position));
      ring.rotation.x = Math.PI / 2;
      ring.name = `${zone.id}-ring`;
      ring.receiveShadow = true;
      this.scene.add(ring);
      this.animatedObjects.push(ring);
    }
  }

  private buildActivityPath(path: readonly VisualRuntimeVector3[]): void {
    const points = path.map(toVector3);
    const geometry = new THREE.BufferGeometry().setFromPoints(points);
    const material = new THREE.LineBasicMaterial({
      color: 0x85d1d6,
    });
    const line = new THREE.Line(geometry, material);
    line.name = "visible-activity-path";
    this.scene.add(line);
  }

  private animate = (): void => {
    if (this.disposed) {
      return;
    }

    const delta = Math.min(this.clock.getDelta(), 0.05);
    const elapsed = this.clock.elapsedTime;

    this.robotGroup.position.y = Math.sin(elapsed * 2.4) * 0.025;
    this.robotGroup.rotation.y = Math.sin(elapsed * 0.35) * 0.08;
    if (elapsed > 0.6) {
      this.host.dataset.vr05Animation = "active";
    }
    for (const part of this.animatedRobotParts) {
      part.mesh.rotation.z = Math.sin(elapsed * 4.1 + part.phaseOffset) * 0.16 * part.swingScale;
      part.mesh.rotation.x = Math.cos(elapsed * 4.1 + part.phaseOffset) * 0.06;
    }

    for (const object of this.animatedObjects) {
      object.rotation.y += delta * 0.45;
      if (object.name.includes("ring")) {
        object.scale.setScalar(1 + Math.sin(elapsed * 2.2) * 0.06);
      }
    }

    this.controls.update();
    this.renderer.render(this.scene, this.camera);
    this.recordMetrics(delta);
    this.animationId = requestAnimationFrame(this.animate);
  };

  private recordMetrics(delta: number): void {
    this.frameAccumulator += delta;
    this.frameCount += 1;
    if (this.frameAccumulator >= 0.5) {
      this.latestFps = Math.round(this.frameCount / this.frameAccumulator);
      this.frameAccumulator = 0;
      this.frameCount = 0;
    }

    this.onMetrics({
      fps: this.latestFps,
      frameTimeMs: Number((delta * 1000).toFixed(2)),
      drawCalls: this.renderer.info.render.calls,
      triangles: this.renderer.info.render.triangles,
      geometries: this.renderer.info.memory.geometries,
      textures: this.renderer.info.memory.textures,
      canvasWidth: this.renderer.domElement.width,
      canvasHeight: this.renderer.domElement.height,
    });
  }
}
