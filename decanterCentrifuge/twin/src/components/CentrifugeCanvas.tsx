'use client';

import { useRef, useEffect, useMemo } from 'react';
import * as THREE from 'three';

interface Props {
  bowlRPM: number;
  scrollRPM: number;
  running: boolean;
}

export default function CentrifugeCanvas({ bowlRPM, scrollRPM, running }: Props) {
  const mountRef = useRef<HTMLDivElement>(null);
  const stateRef = useRef({ bowlRPM, scrollRPM, running });
  useEffect(() => { stateRef.current = { bowlRPM, scrollRPM, running }; }, [bowlRPM, scrollRPM, running]);

  useEffect(() => {
    const mount = mountRef.current;
    if (!mount) return;

    // ── Scene ────────────────────────────────────────────────
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x020714);
    scene.fog = new THREE.Fog(0x020714, 8, 25);

    // ── Camera ───────────────────────────────────────────────
    const camera = new THREE.PerspectiveCamera(40, mount.clientWidth / mount.clientHeight, 0.1, 100);
    camera.position.set(6, 3.5, 6);
    camera.lookAt(0, 0, 0);

    // ── Renderer ─────────────────────────────────────────────
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false });
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    renderer.setSize(mount.clientWidth, mount.clientHeight);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 1.2;
    mount.appendChild(renderer.domElement);

    // ── Lights ───────────────────────────────────────────────
    const ambient = new THREE.AmbientLight(0x0a1628, 0.6);
    scene.add(ambient);

    const topLight = new THREE.DirectionalLight(0x00d4ff, 2.5);
    topLight.position.set(4, 8, 4);
    topLight.castShadow = true;
    topLight.shadow.mapSize.set(2048, 2048);
    scene.add(topLight);

    const fillLight = new THREE.PointLight(0x7c3aed, 3, 12);
    fillLight.position.set(-4, 2, -3);
    scene.add(fillLight);

    const rimLight = new THREE.PointLight(0x00ffaa, 2, 10);
    rimLight.position.set(0, -2, 4);
    scene.add(rimLight);

    const innerGlow = new THREE.PointLight(0x00d4ff, 4, 5);
    innerGlow.position.set(0, 0, 0);
    scene.add(innerGlow);

    // ── Grid floor ───────────────────────────────────────────
    const gridHelper = new THREE.GridHelper(20, 30, 0x0a2040, 0x061224);
    gridHelper.position.y = -2.2;
    scene.add(gridHelper);

    // ── Materials ─────────────────────────────────────────────
    const outerMat = new THREE.MeshPhysicalMaterial({
      color: 0x1a3a5c,
      metalness: 0.85,
      roughness: 0.15,
      transparent: true,
      opacity: 0.45,
      side: THREE.DoubleSide,
      envMapIntensity: 1.2,
    });

    const innerMat = new THREE.MeshPhysicalMaterial({
      color: 0x2563eb,
      metalness: 0.9,
      roughness: 0.1,
      transparent: true,
      opacity: 0.55,
      side: THREE.DoubleSide,
      wireframe: false,
    });

    const screwMat = new THREE.MeshPhysicalMaterial({
      color: 0x00d4ff,
      metalness: 0.95,
      roughness: 0.05,
      emissive: 0x002244,
      emissiveIntensity: 0.4,
    });

    const shaftMat = new THREE.MeshPhysicalMaterial({
      color: 0x7c3aed,
      metalness: 1.0,
      roughness: 0.05,
      emissive: 0x2d0070,
      emissiveIntensity: 0.5,
    });

    const endCapMat = new THREE.MeshPhysicalMaterial({
      color: 0x334155,
      metalness: 0.9,
      roughness: 0.2,
    });

    const glowMat = new THREE.MeshBasicMaterial({
      color: 0x00d4ff,
      transparent: true,
      opacity: 0.12,
      side: THREE.BackSide,
    });

    // ─── OUTER BOWL ───────────────────────────────────────────
    const outerGroup = new THREE.Group();
    const outerGeo = new THREE.CylinderGeometry(1.35, 0.85, 4.8, 64, 1, true);
    const outerMesh = new THREE.Mesh(outerGeo, outerMat);
    outerMesh.castShadow = true;
    outerGroup.add(outerMesh);

    // Outer bowl end caps
    const capFront = new THREE.Mesh(new THREE.CircleGeometry(1.35, 64), endCapMat);
    capFront.rotation.y = Math.PI / 2;
    capFront.position.x = 2.4;
    const capBack = capFront.clone();
    capBack.position.x = -2.4;
    capBack.rotation.y = -Math.PI / 2;
    outerGroup.add(capFront, capBack);

    // Glow halo
    const glowGeo = new THREE.CylinderGeometry(1.5, 1.0, 5.2, 32, 1, true);
    const glowMesh = new THREE.Mesh(glowGeo, glowMat);
    outerGroup.add(glowMesh);

    outerGroup.rotation.z = Math.PI / 2;
    scene.add(outerGroup);

    // ─── PERFORATED INNER BOWL ────────────────────────────────
    const innerGroup = new THREE.Group();
    const innerGeo = new THREE.CylinderGeometry(1.0, 0.62, 4.2, 48, 1, true);
    const innerMesh = new THREE.Mesh(innerGeo, innerMat);
    innerGroup.add(innerMesh);

    // Perforation rings (simulated with wire rings)
    for (let i = 0; i < 16; i++) {
      const ringGeo = new THREE.TorusGeometry(1.01 - i * 0.025, 0.008, 6, 48);
      const ringMat = new THREE.MeshBasicMaterial({ color: 0x00d4ff, transparent: true, opacity: 0.3 });
      const ring = new THREE.Mesh(ringGeo, ringMat);
      ring.position.x = -1.8 + i * 0.25;
      ring.rotation.y = Math.PI / 2;
      innerGroup.add(ring);
    }

    innerGroup.rotation.z = Math.PI / 2;
    scene.add(innerGroup);

    // ─── SCREW / SCROLL CONVEYOR ──────────────────────────────
    const screwGroup = new THREE.Group();

    // Central shaft
    const shaftGeo = new THREE.CylinderGeometry(0.12, 0.12, 4.6, 24);
    const shaft = new THREE.Mesh(shaftGeo, shaftMat);
    screwGroup.add(shaft);

    // Screw flights (helical ribbon approximation using flat discs)
    const flightCount = 40;
    for (let i = 0; i < flightCount; i++) {
      const t = i / flightCount;
      const angle = t * Math.PI * 8; // 4 full turns
      const y = -2.1 + t * 4.2;
      const radius = 0.12 + (0.75 - 0.12) * (0.62 + (1.0 - 0.62) * t) / 1.0; // tapered
      const actualRadius = 0.62 + (1.0 - 0.62) * t;

      const flightGeo = new THREE.CylinderGeometry(actualRadius - 0.12, actualRadius - 0.12, 0.04, 32, 1, true);
      const flight = new THREE.Mesh(flightGeo, screwMat);
      flight.position.y = y;
      flight.rotation.y = angle;
      screwGroup.add(flight);
    }

    screwGroup.rotation.z = Math.PI / 2;
    scene.add(screwGroup);

    // ─── Feed / discharge pipes ───────────────────────────────
    const pipeMat = new THREE.MeshPhysicalMaterial({ color: 0x475569, metalness: 0.8, roughness: 0.3 });

    const feedPipe = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 1.2, 16), pipeMat);
    feedPipe.rotation.z = Math.PI / 2;
    feedPipe.position.set(-3.0, 0.8, 0);
    scene.add(feedPipe);

    const dischargePipe = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 1.0, 16), pipeMat);
    dischargePipe.rotation.z = Math.PI / 2;
    dischargePipe.position.set(3.0, 0.8, 0);
    scene.add(dischargePipe);

    // Motor boxes
    const motorMat = new THREE.MeshPhysicalMaterial({ color: 0x1e293b, metalness: 0.7, roughness: 0.4 });
    const motor1 = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.5, 0.5), motorMat);
    motor1.position.set(-3.2, -0.5, 0);
    scene.add(motor1);
    const motor2 = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.5, 0.5), motorMat);
    motor2.position.set(3.2, -0.5, 0);
    scene.add(motor2);

    // Motor labels glow spheres
    const motorGlowMat1 = new THREE.MeshBasicMaterial({ color: 0x00d4ff });
    const motorGlowMat2 = new THREE.MeshBasicMaterial({ color: 0x7c3aed });
    const mg1 = new THREE.Mesh(new THREE.SphereGeometry(0.06, 12, 12), motorGlowMat1);
    mg1.position.set(-3.2, -0.18, 0);
    scene.add(mg1);
    const mg2 = new THREE.Mesh(new THREE.SphereGeometry(0.06, 12, 12), motorGlowMat2);
    mg2.position.set(3.2, -0.18, 0);
    scene.add(mg2);

    // ─── Orbit controls (manual mouse rotation) ───────────────
    let isDragging = false;
    let prevMouse = { x: 0, y: 0 };
    let theta = Math.PI / 4;
    let phi   = Math.PI / 4;
    const radius = 9;

    const onMouseDown = (e: MouseEvent) => { isDragging = true; prevMouse = { x: e.clientX, y: e.clientY }; };
    const onMouseUp   = () => { isDragging = false; };
    const onMouseMove = (e: MouseEvent) => {
      if (!isDragging) return;
      const dx = (e.clientX - prevMouse.x) * 0.005;
      const dy = (e.clientY - prevMouse.y) * 0.005;
      theta -= dx;
      phi = Math.max(0.1, Math.min(Math.PI / 2, phi + dy));
      prevMouse = { x: e.clientX, y: e.clientY };
    };
    mount.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mouseup',   onMouseUp);
    window.addEventListener('mousemove', onMouseMove);

    // ── Resize observer ───────────────────────────────────────
    const resizeObs = new ResizeObserver(() => {
      camera.aspect = mount.clientWidth / mount.clientHeight;
      camera.updateProjectionMatrix();
      renderer.setSize(mount.clientWidth, mount.clientHeight);
    });
    resizeObs.observe(mount);

    // ── Animation loop ────────────────────────────────────────
    const timer = new THREE.Timer();
    let animId: number;

    const animate = () => {
      animId = requestAnimationFrame(animate);
      const elapsed = timer.getElapsed();
      const { bowlRPM: bRPM, scrollRPM: sRPM, running: isRunning } = stateRef.current;

      if (isRunning) {
        const bowlOmega   = (bRPM / 60) * Math.PI * 2;
        const scrollOmega = (sRPM / 60) * Math.PI * 2;

        // Outer bowl rotation (around X axis because group is rotated Z 90°)
        outerGroup.rotation.x  = elapsed * bowlOmega * 0.05;
        // Inner bowl rotates with bowl (same speed)
        innerGroup.rotation.x  = elapsed * bowlOmega * 0.05;
        // Screw rotates slower (different direction)
        screwGroup.rotation.x  = -elapsed * scrollOmega * 0.05;

        // Pulse inner glow
        innerGlow.intensity = 3 + Math.sin(elapsed * 4) * 1.5;
        fillLight.intensity = 2.5 + Math.sin(elapsed * 2.3) * 0.8;
      }

      // Camera orbit
      camera.position.x = radius * Math.sin(phi) * Math.sin(theta);
      camera.position.y = radius * Math.cos(phi);
      camera.position.z = radius * Math.sin(phi) * Math.cos(theta);
      camera.lookAt(0, 0, 0);

      renderer.render(scene, camera);
    };
    animate();

    return () => {
      cancelAnimationFrame(animId);
      resizeObs.disconnect();
      mount.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mouseup', onMouseUp);
      window.removeEventListener('mousemove', onMouseMove);
      mount.removeChild(renderer.domElement);
      renderer.dispose();
    };
  }, []);

  return (
    <div
      ref={mountRef}
      className="w-full h-full cursor-grab active:cursor-grabbing"
      style={{ minHeight: 340 }}
    />
  );
}
